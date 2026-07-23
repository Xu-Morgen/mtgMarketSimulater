import { z } from "zod";

export const narrativeSchema = z.object({
  headline: z.string().min(1).max(80),
  summary: z.string().min(1).max(800),
  highlights: z.array(z.string().min(1).max(180)).min(1).max(3),
  npcQuote: z.string().min(1).max(240),
  tone: z.enum(["victory", "defeat", "tense", "neutral"])
});

export type Narrative = z.infer<typeof narrativeSchema>;
