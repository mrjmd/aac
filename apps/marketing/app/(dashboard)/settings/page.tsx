import { loadBrandProfile } from "@/lib/brand-profile";
import { Check, X, AlertCircle } from "lucide-react";

export default function SettingsPage() {
  let profile: ReturnType<typeof loadBrandProfile>;
  try {
    profile = loadBrandProfile();
  } catch (e) {
    return (
      <div className="max-w-3xl">
        <h1 className="font-display text-2xl font-bold text-aac-dark">
          Settings
        </h1>
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-600">
          Failed to load brand profile: {String(e)}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-2xl font-bold text-aac-dark">
        Settings
      </h1>
      <p className="mt-1 text-sm text-zinc-400">
        Brand profile and configuration.
      </p>

      {/* Brand Profile */}
      <section className="mt-8">
        <h2 className="font-display text-lg font-bold text-aac-dark">
          Brand Profile
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          Parsed from{" "}
          <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">
            content/brand-profile-attack-a-crack.md
          </code>
        </p>

        <div className="mt-4 space-y-6">
          {/* Business Info */}
          <Card title="Business">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="font-medium text-zinc-500">Name</dt>
              <dd>{profile.business.name}</dd>
              <dt className="font-medium text-zinc-500">Tagline</dt>
              <dd>{profile.business.tagline}</dd>
              <dt className="font-medium text-zinc-500">Industry</dt>
              <dd>{profile.business.industry}</dd>
              <dt className="font-medium text-zinc-500">Location</dt>
              <dd>{profile.business.location}</dd>
              <dt className="font-medium text-zinc-500">Phone</dt>
              <dd>{profile.business.phone}</dd>
              <dt className="font-medium text-zinc-500">Website</dt>
              <dd>{profile.business.website}</dd>
            </dl>
          </Card>

          {/* Voice & Tone */}
          <Card title="Voice & Tone">
            <p className="text-sm text-zinc-600">{profile.voice.description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {profile.voice.toneKeywords.map((kw) => (
                <span
                  key={kw}
                  className="rounded-full bg-aac-blue/10 px-2.5 py-0.5 text-xs font-medium text-aac-blue"
                >
                  {kw}
                </span>
              ))}
            </div>
            {profile.voice.personality && (
              <p className="mt-3 text-sm italic text-zinc-500">
                {profile.voice.personality}
              </p>
            )}
          </Card>

          {/* Phrases */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card title="Phrases to Use">
              <ul className="space-y-1.5 text-sm">
                {profile.phrasesToUse.map((p) => (
                  <li key={p} className="flex items-start gap-2">
                    <Check
                      size={14}
                      className="mt-0.5 shrink-0 text-emerald-500"
                    />
                    <span className="text-zinc-600">{cleanQuotes(p)}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Phrases to Avoid">
              <ul className="space-y-1.5 text-sm">
                {profile.phrasesToAvoid.map((p) => (
                  <li key={p} className="flex items-start gap-2">
                    <X size={14} className="mt-0.5 shrink-0 text-red-400" />
                    <span className="text-zinc-600">{cleanQuotes(p)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* Content Pillars */}
          <Card title="Content Pillars">
            <div className="space-y-3">
              {profile.contentPillars.map((pillar) => (
                <div key={pillar.name}>
                  <p className="text-sm font-semibold text-aac-dark">
                    {pillar.name}
                  </p>
                  <p className="text-sm text-zinc-500">{pillar.description}</p>
                  {pillar.goal && (
                    <p className="text-xs text-zinc-400">
                      Goal: {pillar.goal}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {/* Services */}
          <Card title="Services">
            <ul className="grid gap-1 text-sm text-zinc-600 sm:grid-cols-2">
              {profile.services.map((s) => (
                <li key={s} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-aac-blue" />
                  {s}
                </li>
              ))}
            </ul>
          </Card>

          {/* CTA Rules */}
          <Card title="CTA Rules by Platform">
            <div className="space-y-4">
              {Object.entries(profile.ctaRules).map(([platform, data]) => (
                <div key={platform}>
                  <p className="text-sm font-semibold text-aac-dark">
                    {platform}
                  </p>
                  <ul className="mt-1 space-y-1 text-sm text-zinc-500">
                    {data.rules.map((rule, i) => (
                      <li key={i}>- {cleanQuotes(rule)}</li>
                    ))}
                    {data.maxChars > 0 && (
                      <li className="text-xs text-zinc-400">
                        Max: {data.maxChars.toLocaleString()} characters
                      </li>
                    )}
                  </ul>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </section>

      {/* Environment / API Keys */}
      <section className="mt-10">
        <h2 className="font-display text-lg font-bold text-aac-dark">
          API Configuration
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          API keys are configured via environment variables.
        </p>

        <div className="mt-4">
          <Card title="Environment Variables">
            <div className="space-y-2.5 text-sm">
              <EnvStatus name="GEMINI_API_KEY" />
              <EnvStatus name="BUFFER_ACCESS_TOKEN" />
              <EnvStatus name="TURSO_DATABASE_URL" />
              <EnvStatus name="TURSO_AUTH_TOKEN" />
              <EnvStatus name="BLOB_READ_WRITE_TOKEN" />
              <EnvStatus name="AUTH_SECRET" />
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}

// ── Components ─────────────────────────────────────────────────────

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        {title}
      </h3>
      {children}
    </div>
  );
}

function EnvStatus({ name }: { name: string }) {
  const set = !!process.env[name];
  return (
    <div className="flex items-center gap-2.5">
      {set ? (
        <Check size={14} className="text-emerald-500" />
      ) : (
        <AlertCircle size={14} className="text-amber-500" />
      )}
      <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{name}</code>
      <span className="text-xs text-zinc-400">{set ? "Set" : "Not set"}</span>
    </div>
  );
}

function cleanQuotes(s: string): string {
  return s.replace(/^[""]|[""]$/g, "").replace(/\(.*?\)\s*$/, "").trim();
}
