/**
 * The artifacts an agent has made for the signed-in person, as its manage
 * routes list them (`GET /eve/v1/kyb/artifacts`, manage 0.25+).
 *
 * The agent decides whose they are: the list is already only the caller's
 * own, plus, for someone who manages the agent, what a routine made. Nothing
 * here filters; it only refuses entries that are not the shape it expects, so
 * a malformed list cannot put an id the viewer would refuse into a row.
 */

export interface ArtifactSummary {
  id: string;
  title: string;
  format: "html" | "markdown";
  display: "inline" | "document";
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** The same id rule the viewer applies before it fetches. */
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function artifactList(body: unknown): ArtifactSummary[] {
  const rows = (body as { artifacts?: unknown } | null)?.artifacts;
  if (!Array.isArray(rows)) return [];
  const out: ArtifactSummary[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    if (typeof r?.id !== "string" || !ARTIFACT_ID.test(r.id)) continue;
    const version = Number(r.version);
    out.push({
      id: r.id,
      title: typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 200) : "Untitled",
      format: r.format === "markdown" ? "markdown" : "html",
      display: r.display === "inline" ? "inline" : "document",
      version: Number.isInteger(version) && version > 0 ? version : 1,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : "",
    });
  }
  // Newest first, whatever order the agent answered in.
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
