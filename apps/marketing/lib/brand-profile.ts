import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export interface BrandColors {
  primary: string;
  accent: string;
  dark: string;
  white: string;
  lightGray: string;
}

export interface BrandTypography {
  headline: string;
  body: string;
  cta: string;
}

export interface BrandLogo {
  file: string;
  description: string;
  placement: string;
  size: string;
}

export interface PostTemplate {
  id: string;        // A, B, C, etc.
  name: string;
  layout: string;
  bestFor: string;
  examples: Record<string, string>; // headline, callout, badge text, etc.
}

export interface ExamplePost {
  title: string;
  template: string;
  elements: Record<string, string>; // headline, callout, caption, background, etc.
}

export interface BrandProfile {
  business: {
    name: string;
    tagline: string;
    industry: string;
    location: string;
    phone: string;
    website: string;
  };
  services: string[];
  audiences: { label: string; description: string }[];
  voice: {
    description: string;
    toneKeywords: string[];
    personality: string;
    readingLevel: string;
  };
  phrasesToUse: string[];
  phrasesToAvoid: string[];
  contentPillars: { name: string; description: string; goal: string }[];
  ctaRules: Record<string, { rules: string[]; maxChars: number }>;
  colors: BrandColors;
  typography: BrandTypography;
  logo: BrandLogo;
  designLanguage: string[];
  photographyStyle: string[];
  templates: PostTemplate[];
  examplePosts: ExamplePost[];
}

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse the brand profile markdown into structured data.
 * Uses synchronous read to avoid async issues in Next.js server components.
 */
export function loadBrandProfile(): BrandProfile {
  const filePath = join(
    process.cwd(),
    "content",
    "brand-profile-attack-a-crack.md",
  );
  const raw = readFileSync(filePath, "utf-8");
  return parseBrandProfile(raw);
}

export function parseBrandProfile(markdown: string): BrandProfile {
  const sections = splitSections(markdown);

  const visualIdentity = sections["Visual Identity"] ?? "";

  return {
    business: parseBusiness(sections["Business"] ?? ""),
    services: parseBulletList(sections["Services"] ?? ""),
    audiences: parseAudiences(sections["Target Audiences"] ?? ""),
    voice: parseVoice(sections["Voice & Tone"] ?? ""),
    phrasesToUse: parseBulletList(
      extractSubsection(sections["Voice & Tone"] ?? "", "Phrases to Use"),
    ),
    phrasesToAvoid: parseBulletList(
      extractSubsection(sections["Voice & Tone"] ?? "", "Phrases to Avoid"),
    ),
    contentPillars: parsePillars(sections["Content Pillars"] ?? ""),
    ctaRules: parseCtaRules(sections["CTA Rules by Platform"] ?? ""),
    colors: parseColors(extractSubsection(visualIdentity, "Colors")),
    typography: parseTypography(extractSubsection(visualIdentity, "Typography")),
    logo: parseLogo(extractSubsection(visualIdentity, "Logo")),
    designLanguage: parseBulletList(
      extractSubsection(visualIdentity, "Design Language — Neo-Brutalist"),
    ),
    photographyStyle: parseBulletList(
      extractSubsection(visualIdentity, "Photography Style"),
    ),
    templates: parseTemplates(sections["Post Templates"] ?? ""),
    examplePosts: parseExamplePosts(sections["Example Posts"] ?? ""),
  };
}

// ── Section Splitter ───────────────────────────────────────────────

function splitSections(md: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = md.split("\n");
  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)/);
    if (h2Match) {
      if (currentSection) {
        result[currentSection] = currentContent.join("\n").trim();
      }
      currentSection = h2Match[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  if (currentSection) {
    result[currentSection] = currentContent.join("\n").trim();
  }
  return result;
}

function extractSubsection(sectionText: string, subsectionName: string): string {
  const lines = sectionText.split("\n");
  let capturing = false;
  const captured: string[] = [];

  for (const line of lines) {
    const h3Match = line.match(/^### (.+)/);
    if (h3Match) {
      if (capturing) break;
      if (h3Match[1].trim() === subsectionName) {
        capturing = true;
        continue;
      }
    }
    if (capturing) captured.push(line);
  }
  return captured.join("\n").trim();
}

// ── Individual Parsers ─────────────────────────────────────────────

function parseBusiness(text: string): BrandProfile["business"] {
  const get = (key: string) => {
    const match = text.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+)`));
    return match?.[1]?.trim() ?? "";
  };
  return {
    name: get("Name"),
    tagline: get("Tagline"),
    industry: get("Industry"),
    location: get("Location"),
    phone: get("Phone"),
    website: get("Website"),
  };
}

function parseBulletList(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.match(/^- /))
    .map((line) => line.replace(/^- /, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
}

function parseAudiences(
  text: string,
): { label: string; description: string }[] {
  return text
    .split("\n")
    .filter((line) => line.match(/^- \*\*/))
    .map((line) => {
      const match = line.match(/^- \*\*(.+?):\*\*\s*(.+)/);
      if (!match) return null;
      return { label: match[1].trim(), description: match[2].trim() };
    })
    .filter((x): x is { label: string; description: string } => x !== null);
}

function parseVoice(text: string): BrandProfile["voice"] {
  const get = (key: string) => {
    const match = text.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+)`));
    return match?.[1]?.trim() ?? "";
  };
  return {
    description: get("Voice"),
    toneKeywords: get("Tone keywords")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    personality: get("Personality"),
    readingLevel: get("Reading level"),
  };
}

function parsePillars(
  text: string,
): { name: string; description: string; goal: string }[] {
  return text
    .split("\n")
    .filter((line) => line.match(/^\d+\./))
    .map((line) => {
      const match = line.match(
        /^\d+\.\s*\*\*(.+?)\*\*\s*[—–-]\s*(.+?)(?:\.\s*Goal:\s*(.+))?$/,
      );
      if (!match) return null;
      return {
        name: match[1].trim(),
        description: match[2].trim().replace(/\.\s*$/, ""),
        goal: match[3]?.trim().replace(/\.\s*$/, "") ?? "",
      };
    })
    .filter((x): x is { name: string; description: string; goal: string } => x !== null);
}

function parseCtaRules(
  text: string,
): Record<string, { rules: string[]; maxChars: number }> {
  const result: Record<string, { rules: string[]; maxChars: number }> = {};
  const lines = text.split("\n");
  let currentPlatform = "";

  for (const line of lines) {
    const h3Match = line.match(/^### (.+)/);
    if (h3Match) {
      currentPlatform = h3Match[1].trim();
      result[currentPlatform] = { rules: [], maxChars: 0 };
      continue;
    }
    if (currentPlatform && line.match(/^- /)) {
      const ruleText = line.replace(/^- /, "").trim();
      const charMatch = ruleText.match(/Max ([\d,]+) characters/);
      if (charMatch) {
        result[currentPlatform].maxChars = parseInt(
          charMatch[1].replace(/,/g, ""),
          10,
        );
      } else {
        result[currentPlatform].rules.push(ruleText);
      }
    }
  }
  return result;
}

function parseColors(text: string): BrandColors {
  const getHex = (key: string) => {
    const match = text.match(new RegExp(`\\*\\*${key}[^*]*\\*\\*\\s*#([0-9a-fA-F]{6})`));
    return match ? `#${match[1]}` : "";
  };
  return {
    primary: getHex("Primary") || "#1e6fb8",
    accent: getHex("Accent") || "#f0c34b",
    dark: getHex("Dark") || "#1a1a1a",
    white: getHex("White") || "#ffffff",
    lightGray: getHex("Light Gray") || "#f5f5f5",
  };
}

function parseTypography(text: string): BrandTypography {
  const get = (key: string) => {
    const match = text.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+)`));
    return match?.[1]?.trim() ?? "";
  };
  return {
    headline: get("Headlines"),
    body: get("Body"),
    cta: get("CTA buttons"),
  };
}

function parseLogo(text: string): BrandLogo {
  const get = (key: string) => {
    const match = text.match(new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+)`));
    return match?.[1]?.trim() ?? "";
  };
  return {
    file: get("File"),
    description: get("Description"),
    placement: get("Placement"),
    size: get("Size"),
  };
}

function parseTemplates(text: string): PostTemplate[] {
  const templates: PostTemplate[] = [];
  const lines = text.split("\n");
  let current: Partial<PostTemplate> | null = null;
  let capturingLayout: string[] = [];

  for (const line of lines) {
    const h3Match = line.match(/^### Template ([A-I]):\s*(.+?)(?:\s*\((.+?)\))?$/);
    if (h3Match) {
      if (current?.id) {
        current.layout = capturingLayout.join(" ").trim();
        templates.push(current as PostTemplate);
      }
      current = {
        id: h3Match[1],
        name: h3Match[2].trim(),
        layout: "",
        bestFor: "",
        examples: {},
      };
      capturingLayout = [];
      continue;
    }
    if (!current) continue;

    const bestForMatch = line.match(/^\*\*Best for:\*\*\s*(.+)/);
    if (bestForMatch) {
      current.bestFor = bestForMatch[1].trim();
      continue;
    }
    const exampleMatch = line.match(/^\*\*Example\s+(.+?):\*\*\s*"?(.+?)"?\s*$/);
    if (exampleMatch) {
      current.examples = current.examples ?? {};
      current.examples[exampleMatch[1].trim().toLowerCase()] =
        exampleMatch[2].replace(/^"|"$/g, "").trim();
      continue;
    }
    if (line.startsWith("- ")) {
      capturingLayout.push(line.replace(/^- /, "").replace(/\*\*/g, "").trim());
    }
  }
  if (current?.id) {
    current.layout = capturingLayout.join(" ").trim();
    templates.push(current as PostTemplate);
  }
  return templates;
}

function parseExamplePosts(text: string): ExamplePost[] {
  const posts: ExamplePost[] = [];
  const lines = text.split("\n");
  let current: ExamplePost | null = null;

  for (const line of lines) {
    const h3Match = line.match(/^### Example \d+\s*[—–-]\s*(.+?)(?:\s*\(Template ([A-I])\))?$/);
    if (h3Match) {
      if (current) posts.push(current);
      current = {
        title: h3Match[1].trim(),
        template: h3Match[2] ?? "",
        elements: {},
      };
      continue;
    }
    if (!current) continue;

    const kvMatch = line.match(/^- \*\*(.+?):\*\*\s*(.+)/);
    if (kvMatch) {
      current.elements[kvMatch[1].trim().toLowerCase()] =
        kvMatch[2].replace(/^"|"$/g, "").trim();
    }
  }
  if (current) posts.push(current);
  return posts;
}
