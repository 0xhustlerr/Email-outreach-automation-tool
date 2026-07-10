import { markUserActivity } from "@/lib/avatar-prefetch";
import {
  GitHubError,
  buildPatchUrl,
  fetchPatch,
  listCommits,
  listUserRepos,
} from "@/lib/github";
import { extractTelegrams, extractPhones } from "@/lib/discover";
import {
  extractAuthorFromPatch,
  extractCommitTzOffset,
  extractPatchMessage,
  isPublicEmail,
} from "@/lib/patch";
import type { ScanEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  owner?: string;
  repo?: string;
  commitsPerRepo?: number;
};

const DEFAULT_COMMITS_PER_REPO = 5;
const DEFAULT_REPO_LIMIT = 30;
const MAX_COMMITS_PER_REPO = 100;
const MAX_REPO_LIMIT = 100;

function envInt(name: string, fallback: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

function repoLimit(): number {
  return envInt("SCAN_REPO_LIMIT", DEFAULT_REPO_LIMIT, MAX_REPO_LIMIT);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request) {
  markUserActivity();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError(400, "Request body must be JSON.");
  }

  const owner = (body.owner ?? "").trim();
  const repo = (body.repo ?? "").trim();
  const commitsPerRepo = clamp(
    Number(body.commitsPerRepo) || DEFAULT_COMMITS_PER_REPO,
    1,
    MAX_COMMITS_PER_REPO,
  );
  if (!owner) return jsonError(400, "owner is required.");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ScanEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        // Single-repo mode if `repo` is given, otherwise scan all non-fork repos
        // (capped by SCAN_REPO_LIMIT, default 30) with `commitsPerRepo` each.
        let targetRepos: string[];
        if (repo) {
          targetRepos = [repo];
        } else {
          const repos = await listUserRepos(owner);
          targetRepos = repos
            .filter((r) => !r.fork)
            .slice(0, repoLimit())
            .map((r) => r.name);
        }

        if (targetRepos.length === 0) {
          send({ type: "start", totalCommits: 0, repoCount: 0 });
          send({ type: "done", matches: 0, scanned: 0, repoCount: 0 });
          controller.close();
          return;
        }

        // Pull commit lists in parallel; tolerate empty/inaccessible repos but
        // still bail on a rate-limit response.
        const commitLists = await Promise.all(
          targetRepos.map(async (r) => {
            try {
              return {
                repo: r,
                commits: await listCommits(owner, r, commitsPerRepo),
              };
            } catch (err) {
              if (err instanceof GitHubError && err.rateLimited) throw err;
              return { repo: r, commits: [] };
            }
          }),
        );

        const plan = commitLists.filter((p) => p.commits.length > 0);
        const totalCommits = plan.reduce((n, p) => n + p.commits.length, 0);

        send({
          type: "start",
          totalCommits,
          repoCount: plan.length,
        });

        const seenEmails = new Set<string>();
        const seenTelegrams = new Set<string>();
        const seenPhones = new Set<string>();
        let matches = 0;
        let globalIndex = 0;

        for (const { repo: rname, commits } of plan) {
          send({
            type: "repo-start",
            repo: rname,
            commitCount: commits.length,
          });

          for (const commit of commits) {
            globalIndex++;
            send({
              type: "progress",
              index: globalIndex,
              total: totalCommits,
              repo: rname,
              sha: commit.sha,
            });

            const patchUrl = buildPatchUrl(owner, rname, commit.sha);
            let patch: string;
            try {
              patch = await fetchPatch(patchUrl);
            } catch (err) {
              if (err instanceof GitHubError && err.rateLimited) {
                send({ type: "error", message: err.message });
                controller.close();
                return;
              }
              send({
                type: "skipped",
                index: globalIndex,
                total: totalCommits,
                repo: rname,
                sha: commit.sha,
                reason: "patch fetch failed",
              });
              continue;
            }

            const rawAuthor = extractAuthorFromPatch(patch);
            const publicAuthor =
              rawAuthor && isPublicEmail(rawAuthor.email) ? rawAuthor : null;
            const emailKey = publicAuthor?.email.toLowerCase() ?? null;
            const newAuthor =
              publicAuthor && emailKey && !seenEmails.has(emailKey)
                ? publicAuthor
                : null;

            // Commit message body only - keeps the diff out so fixtures and
            // source strings can't masquerade as contact info.
            const message = extractPatchMessage(patch);
            const newTelegrams = extractTelegrams(message).filter(
              (t) => !seenTelegrams.has(t),
            );
            const newPhones = extractPhones(message).filter(
              (p) => !seenPhones.has(p),
            );

            if (
              !newAuthor &&
              newTelegrams.length === 0 &&
              newPhones.length === 0
            ) {
              let reason: string;
              if (!rawAuthor) reason = "no From: header and no new contacts";
              else if (!publicAuthor)
                reason = `noreply address (${rawAuthor.email})`;
              else if (emailKey && seenEmails.has(emailKey))
                reason = `duplicate of ${rawAuthor.email}`;
              else reason = "no new contacts";
              send({
                type: "skipped",
                index: globalIndex,
                total: totalCommits,
                repo: rname,
                sha: commit.sha,
                reason,
              });
              continue;
            }

            if (newAuthor && emailKey) seenEmails.add(emailKey);
            for (const t of newTelegrams) seenTelegrams.add(t);
            for (const p of newPhones) seenPhones.add(p);
            matches++;

            send({
              type: "match",
              index: globalIndex,
              total: totalCommits,
              match: {
                repo: rname,
                sha: commit.sha,
                patchUrl,
                author: newAuthor,
                telegrams: newTelegrams,
                phones: newPhones,
                date: commit.date,
                tzOffsetMin: extractCommitTzOffset(patch),
              },
            });
          }
        }

        send({
          type: "done",
          matches,
          scanned: globalIndex,
          repoCount: plan.length,
        });
        controller.close();
      } catch (err) {
        const message =
          err instanceof GitHubError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Unknown error while scanning commits.";
        send({ type: "error", message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
