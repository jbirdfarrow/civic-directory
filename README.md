# Civic Directory

Source-tracked records of national officeholders for the IDEAS For Us **Civic Lookup** app (websim.com/@ideas/civic-lookup).

Every record names the page it came from and shows how far it has been checked. The app shows that status to everyone who uses it.

## What the statuses mean

| Status | Meaning |
| --- | --- |
| Verified | A second person confirmed it on an official government, parliament or election-authority page, and it has a re-check date. |
| Unverified | Matched to an official page, but not yet confirmed by a second person. |
| Unverified · Wikidata | From Wikidata only. Not yet checked against any official page. |
| Needs re-check | Was verified, but its re-check date has passed. |
| Disputed | Sources disagree. The record's notes say how. |

Wikidata, news and manual entries can never make a record Verified on their own.

## Layout

| Path | What it holds |
| --- | --- |
| `data/countries/XX.json` | One file per country, named by its ISO 3166-1 code. |
| `data/index.json` | Which countries have records, with counts by status. Rebuilt automatically. The app reads this. |
| `schema/directory.schema.json` | The format every country file must follow. |
| `lib/directory.js` | The checking rules and the card display, shared with the app. |
| `tools/` | Validation, index and Wikidata scripts. |
| `app/` | A copy of the Civic Lookup app's code, pushed from the app's Admin panel. |
| `reports/wikidata-check.md` | Where Wikidata disagrees with officially sourced records. |

## How changes get in

1. **Admin panel (normal route).** In Civic Lookup, open Admin, connect with a GitHub token, edit or review records, and commit. Each commit is checked by the Validate action.
2. **Wikidata sync.** Monthly, or on demand from the Actions tab. Fills countries that have no official records, labeled as Wikidata. It never changes officially sourced records.
3. **By hand.** Edit a country file and push. The Validate action rejects anything that breaks the rules.

## Admin panel token

Create a fine-grained token at GitHub → Settings → Developer settings → Fine-grained tokens:

- **Repository access:** Only select repositories → `civic-directory`
- **Permissions:** Contents → Read and write (Metadata read is added automatically)
- **Expiration:** 90 days or less

The panel keeps the token only for the current browser tab and forgets it when the tab closes. Never paste it anywhere else.

## Run the checks locally

```
npm install
npm run validate
npm run index
```
