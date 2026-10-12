# Publishing a study to the community

Goal: a social scientist who built a study in the app clicks **Publish**, and a few minutes later
their reconstruction is on the HumanStudy community (HumanStudy-Bench on GitHub) under their own
name, without knowing what a pull request is. People who do use GitHub get the same result as a
PR they authored.

## 1. What is published

One **contribution** = one reconstruction of one paper by one person (or team):

```text
program.json                      the Human Program (Study document)
package/<slug>/…                  the eight-file runnable package (if built)
artifacts/simulations/<stamp>/    report.md, evaluation.json, results.png (optional)
CONTRIBUTION.json                 attribution, licence, paper key, app version, checks passed
```

Not published by default: `paper.pdf` and anything under `sources/` (copyright). The wizard has
one checkbox, "Include the paper PDF (open access, or I hold the rights)", off by default. The
program's evidence quotes are short and stay; they are the citations.

Licence: CC BY 4.0 for `program.json`, materials and reports; MIT for code (`task/`,
`evaluation/`), matching HumanStudy-Bench. Shown once in the wizard, remembered per account.

## 2. Same paper, several people

A paper is identified by a **paper key**: its DOI when the agent can find one in the PDF
(`doi:10.1111/1468-0017.00215`), otherwise `title:<normalised-title>-<year>-<first-author>`.
The key is computed in the app and confirmed in the wizard ("Is this the paper? ✓").

Every contribution lives in its own folder, so two people never edit the same file:

```text
community/
  doi_10.1111_1468-0017.00215/        one folder per paper key (`:` and `/` become `_`)
    paper.json                        DOI, title, authors, year, venue (first contributor writes it)
    knobe-2003--hs-7f3a/              <slug>--<contributor id>: a contribution
    knobe-2003--gh-xuanl17/
    knobe-2003--gh-xuanl17-v2/        an update by the same person keeps the old one
```

Rules:

- A new reconstruction of an existing paper is **always accepted** as a new folder. It is not a
  conflict; it is a second independent reconstruction. The study page lists all of them side by
  side (contributor, date, conditions, N, steps, open issues, verbatim coverage, simulation
  outcome). Agreement between independent reconstructions is itself a measure of how
  reproducible the paper is, which is a result the community wants.
- Before publishing, the app tells the user: "2 reconstructions of this paper already exist.
  Open them · Start from one of them · Publish mine as a third." Starting from one is the
  existing **Fork** in the Studies tab.
- Changing **someone else's** contribution is a proposal: it becomes a PR against their folder,
  reviewed by that contributor (notified by email through the Hub) or by a maintainer after 14
  days. The app offers this as "Suggest a correction" on a study page; it is the only path that
  needs human review.
- Updating **your own** contribution is a new folder with `-v2`, `-v3`; the study page shows the
  latest and keeps history. No rebase, no force push, nothing to resolve.
- A maintainer can mark one contribution as **reference** for the paper (shown first, used by the
  benchmark). Default: the most complete one (fewest blocking issues, highest verbatim coverage,
  a passing simulation) until a maintainer chooses.

## 3. Who gets the credit

The wizard asks once per account for **name, affiliation (optional), ORCID (optional)** and
stores them on the Hub account. Then one of two paths, chosen automatically:

| | Has GitHub | No GitHub |
|---|---|---|
| Button | "Connect GitHub" (device flow: open github.com, type a 8-letter code) | nothing to do |
| PR author | the user's GitHub account | `humanstudy-bot` |
| Attribution | `contributors[].github` + commit author | `contributors[].name/orcid/hub` + `Co-authored-by: Name <hub-id@users.humanstudy-hub.com>` trailer, PR body "Submitted by Name via HumanStudy Hub" |
| Profile page | links to their GitHub | links to their Hub profile |

Both go through the same server endpoint; the only difference is which token opens the PR. A
user can connect GitHub later and claim earlier bot contributions (the server re-labels them).

The Bench CI rule "index must name the PR author as a contributor" becomes: PR author is in
`contributors[].github`, **or** PR author is `humanstudy-bot` and `CONTRIBUTION.json` carries a
Hub id signed by the server (HMAC with the same `ACCESS_SECRET` as the desktop keys).

## 4. Publishing flow, as the user sees it

```
Study tab · "Publish to community"
  1 Check      runs .opencode/skills/build/check_package.py and the schema check;
               shows readiness and open issues ("3 decisions still open — publish anyway?")
  2 Paper      "Knobe (2003) Intentional action and side effects…  DOI 10.1111/… ✓"
               "2 reconstructions exist" → Open / Start from / Continue
  3 You        name · affiliation · ORCID · [Connect GitHub]   (prefilled after the first time)
  4 Licence    CC BY 4.0 + MIT · [ ] include paper PDF
  5 Publish    progress: packing → uploading → checks on GitHub (2–5 min) → published
               link to the study page and to the PR; status also in Studies → "My contributions"
```

If GitHub's checks fail (invalid JSON, smoke test), the app shows the CI message in plain words
and offers "Ask the agent to fix this", then re-publish replaces the same PR.

Auto-merge: a PR that only **adds** a new contribution folder and passes CI is merged by the bot
without a human. PRs that touch existing folders wait for review (section 2).

## 5. Pieces to build (wave M3)

**HumanStudy-Bench**
- `community/` layout, `paper.json`, `CONTRIBUTION.json` schema; `scripts/build_studies_index.py`
  reads both `studies/` and `community/` (index entries get `paperKey`, `contributions[]`).
- CI: validate new contribution folders (`validate_package.py` when `package/` exists, schema
  check on `program.json`, no files outside the folder, size limit, no PDF unless
  `CONTRIBUTION.json.includesPdf` and licence flag), contributor rule from section 3,
  auto-merge label for add-only PRs.

**humanstudy-hub-web (server)**
- `POST /api/community/publish` (Hub JWT): receives the contribution as a zip (≤ 25 MB; the PDF
  only when flagged), validates, writes the folder through the GitHub API as the user (if a
  GitHub token is connected) or as the bot (GitHub App installation token; never a personal PAT),
  opens the PR, records `{contribution_id, user, paper_key, pr_url, status}` in Supabase
  `contributions`; a webhook on PR events updates `status` (checks_failed / merged / changes
  requested) and emails the user.
- `GET /api/community/paper/<key>` for the "already exists" check; `GET /api/community/mine`.
- GitHub device-flow endpoint to connect a GitHub account to the Hub account (token stored
  encrypted; scope `public_repo` only).
- Study pages on the website: one page per paper key listing contributions and a comparison table.

**Desktop**
- Publish wizard (Study tab button + Studies → My contributions), paper-key detection via the
  agent (`build` skill writes `source.doi` when the PDF states one), the zip, upload with
  progress, status polling, "Suggest a correction" on community study pages.

Order: Bench layout + CI → server endpoint with bot path → app wizard (bot path) → GitHub
connect → suggestions/corrections → reference marking and comparison view.
