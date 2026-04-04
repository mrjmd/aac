import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ── Content Ideas ───────────────────────────────────────────────────

export const contentIdeas = sqliteTable("content_ideas", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  pillar: text("pillar"), // educational, showcase, testimonial, seasonal, personality, blog
  status: text("status").notNull().default("draft"), // draft, approved, revising, rejected, used
  batchId: text("batch_id"), // groups ideas from same generation run
  postId: integer("post_id"), // FK to content_posts when idea becomes a post
  rejectionReason: text("rejection_reason"), // off-brand, wrong-tone, duplicate, irrelevant, other
  revisionFeedback: text("revision_feedback"), // user feedback for current revision request
  version: integer("version").notNull().default(1), // increments on each revise cycle
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Content Posts ───────────────────────────────────────────────────

export const contentPosts = sqliteTable("content_posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  concept: text("concept").notNull(), // what this post is about
  type: text("type").notNull(), // tip, showcase, testimonial, seasonal, personality, blog
  sourceType: text("source_type").notNull().default("ai-full"), // ai-full, ai-caption-only
  templateId: text("template_id"), // A-I, which brand template to use
  visualPrompt: text("visual_prompt"), // the Imagen prompt used (or upload note for ai-caption-only)
  status: text("status").notNull().default("draft"), // draft, generating, review, approved, scheduled, published, failed
  scheduledAt: text("scheduled_at"),
  ideaId: integer("idea_id"), // FK to content_ideas
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Platform Variants ───────────────────────────────────────────────

export const platformVariants = sqliteTable("platform_variants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  postId: integer("post_id").notNull(), // FK to content_posts
  platform: text("platform").notNull(), // instagram, facebook, linkedin, gbp
  caption: text("caption"),
  captionStatus: text("caption_status").notNull().default("pending"), // pending, generated, approved, rejected
  imageUrl: text("image_url"),
  imageStatus: text("image_status").notNull().default("pending"), // pending, generated, approved, rejected
  aspectRatio: text("aspect_ratio"), // 1:1, 3:4, 4:3, 16:9
  bufferPostId: text("buffer_post_id"),
  publishStatus: text("publish_status").notNull().default("draft"), // draft, scheduled, published, failed
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Variant Versions (history) ──────────────────────────────────────

export const variantVersions = sqliteTable("variant_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  variantId: integer("variant_id").notNull(), // FK to platform_variants
  caption: text("caption"),
  imageUrl: text("image_url"),
  feedback: text("feedback"), // what the user said to trigger this version
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});
