import type { AcademicCandidate, ItemSnapshot } from "./aiTypes";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function getJSON(url: string): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await Zotero.HTTP.request("GET", url, {
        timeout: 30000,
        successCodes: false,
      });
      if (response.status === 429 || response.status >= 500) {
        const retry = Number(response.getResponseHeader("Retry-After") || "");
        await sleep(
          Number.isFinite(retry) ? retry * 1000 : 1000 * (attempt + 1),
        );
        continue;
      }
      if (response.status < 200 || response.status >= 300)
        throw new Error(`HTTP ${response.status}`);
      return JSON.parse(response.responseText || "{}");
    } catch (error) {
      last = error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error("Academic search failed");
}

function cleanDOI(value: string) {
  return value.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
}
function creators(author: any[] | undefined) {
  return (author || []).map((a) => ({
    firstName: a.given || a.firstName,
    lastName: a.family || a.lastName,
    name: a.name,
  }));
}
function crossref(work: any): AcademicCandidate {
  return {
    source: "crossref",
    sourceURL: `https://api.crossref.org/works/${encodeURIComponent(work.DOI || "")}`,
    title: work.title?.[0],
    doi: work.DOI,
    venue: work["container-title"]?.[0],
    date: work.published?.["date-parts"]?.[0]?.join("-"),
    volume: work.volume,
    issue: work.issue,
    pages: work.page,
    publisher: work.publisher,
    issn: work.ISSN?.[0],
    url: work.URL,
    abstract: work.abstract,
    creators: creators(work.author),
  };
}
function semantic(paper: any): AcademicCandidate {
  return {
    source: "semantic-scholar",
    sourceURL: `https://api.semanticscholar.org/graph/v1/paper/${paper.paperId}`,
    title: paper.title,
    doi: paper.externalIds?.DOI,
    venue: paper.venue || paper.publicationVenue?.name,
    date: paper.year ? String(paper.year) : undefined,
    url: paper.url,
    abstract: paper.abstract,
    creators: creators(paper.authors),
  };
}

export function extractArxivID(snapshot: ItemSnapshot) {
  const text = Object.values(snapshot.fields).join(" ");
  return text.match(
    /(?:arxiv(?:\.org\/(?:abs|pdf)\/)?|arXiv:)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7})/i,
  )?.[1];
}

export async function searchAcademic(
  snapshot: ItemSnapshot,
  extraQueries: string[] = [],
) {
  const found: AcademicCandidate[] = [];
  const doi = snapshot.fields.DOI && cleanDOI(snapshot.fields.DOI);
  if (doi) {
    try {
      found.push(
        crossref(
          (
            await getJSON(
              `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
            )
          ).message,
        ),
      );
    } catch (_) {
      /* fall through */
    }
  }
  const arxivID = extractArxivID(snapshot);
  if (arxivID) {
    try {
      const xml = await Zotero.HTTP.request(
        "GET",
        `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivID)}`,
        { timeout: 30000 },
      );
      const doc = new DOMParser().parseFromString(
        xml.responseText || "",
        "text/xml",
      );
      const entry = doc?.querySelector("entry");
      if (entry)
        found.push({
          source: "arxiv",
          sourceURL: `https://arxiv.org/abs/${arxivID}`,
          arxivID,
          title: entry.querySelector("title")?.textContent?.trim(),
          abstract: entry.querySelector("summary")?.textContent?.trim(),
          doi:
            entry.getElementsByTagNameNS(
              "http://arxiv.org/schemas/atom",
              "doi",
            )[0]?.textContent || undefined,
          journalRef:
            entry.getElementsByTagNameNS(
              "http://arxiv.org/schemas/atom",
              "journal_ref",
            )[0]?.textContent || undefined,
          creators: Array.prototype.map.call(
            entry.querySelectorAll("author name"),
            (n: Element) => ({ name: n.textContent || "" }),
          ) as Array<{ name: string }>,
        });
    } catch (_) {
      /* arXiv is supplemental evidence */
    }
  }
  const title = snapshot.fields.title || "";
  const queries = [title, ...extraQueries].filter(Boolean).slice(0, 3);
  for (const query of queries) {
    try {
      const data = await getJSON(
        `https://api.semanticscholar.org/graph/v1/paper/search?limit=5&fields=paperId,title,authors,year,venue,publicationVenue,externalIds,url,abstract&query=${encodeURIComponent(query)}`,
      );
      found.push(...(data.data || []).map(semantic));
    } catch (_) {
      /* Crossref search below remains available */
    }
  }
  if (!found.length && title) {
    try {
      const data = await getJSON(
        `https://api.crossref.org/works?rows=5&query.bibliographic=${encodeURIComponent(title)}`,
      );
      found.push(...(data.message?.items || []).map(crossref));
    } catch (_) {
      /* reported by caller */
    }
  }
  return found.slice(0, 15);
}
