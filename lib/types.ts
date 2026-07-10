export type Repo = {
  name: string;
  fullName: string;
  owner: string;
  fork: boolean;
  pushedAt: string | null;
  updatedAt: string | null;
  defaultBranch: string | null;
  htmlUrl: string;
};

export type CommitSummary = {
  sha: string;
  message: string;
  htmlUrl: string;
  // ISO 8601 author date. Null when GitHub omits the field.
  date: string | null;
};

export type PatchAuthor = {
  name: string;
  email: string;
};

export type ScanMatch = {
  repo: string;
  sha: string;
  patchUrl: string;
  // null when the commit has no public From: author but the message body still
  // yielded a new telegram/phone. In that case the contacts arrays carry the
  // new values and the email side stays empty for this match event.
  author: PatchAuthor | null;
  telegrams: string[];
  phones: string[];
  // ISO 8601 author date from the underlying commit. Surfaces on the contact
  // card so users can see how fresh a patch-sourced contact is.
  date: string | null;
  // Author's UTC offset in minutes, parsed from the patch Date header. Their
  // real working timezone - used for local-time send scheduling. Null when the
  // patch had no parseable offset.
  tzOffsetMin?: number | null;
};

export type MailIdentity = { name: string; email: string };

export type DiscoverySourceKind =
  | "profile"
  | "readme"
  | "blog"
  | "readme-link";

export type DiscoverySource = {
  kind: DiscoverySourceKind;
  label: string;
  url: string | null;
  emails: string[];
  telegrams: string[];
  phones: string[];
  note?: string;
};

export type DiscoveryResult = {
  login: string;
  name: string | null;
  blog: string | null;
  // Raw GitHub profile location - "City, Country" or similar free-form.
  location: string | null;
  sources: DiscoverySource[];
};

export type ScanEvent =
  | { type: "start"; totalCommits: number; repoCount: number }
  | { type: "repo-start"; repo: string; commitCount: number }
  | {
      type: "progress";
      index: number;
      total: number;
      repo: string;
      sha: string;
    }
  | {
      type: "skipped";
      index: number;
      total: number;
      repo: string;
      sha: string;
      reason: string;
    }
  | { type: "match"; index: number; total: number; match: ScanMatch }
  | { type: "done"; matches: number; scanned: number; repoCount: number }
  | { type: "error"; message: string };
