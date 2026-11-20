export * as ConfigSkillsV1 from "./skills"

import { Schema } from "effect"

export const Info = Schema.Struct({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
  }),
  excludedPaths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Skill directories to leave out. A skill is excluded when it was discovered at, or below, one of these absolute paths.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
