# IndexNow

Tayf pings IndexNow (Bing, Yandex and other participating engines) when a
story's cache tag is revalidated, so new and updated cluster pages are
crawled quickly. The feature is a complete no-op unless `INDEXNOW_KEY` is set.

## Configuration

- Env var `INDEXNOW_KEY`: 8-128 characters of `A-Za-z0-9-`. 32+ hex characters
  is recommended (for example `openssl rand -hex 16`).
- Set it in the **Production** scope only. Pings are additionally disabled
  when `VERCEL_ENV` is anything other than `production`, or when the site URL
  is not `https://`.
- Never commit the key or log it. The code never logs it.

## Key location

The key ownership file is served at `/indexnow-key.txt` (the body is exactly
the key, `text/plain`). With the key unset or invalid the route returns 404.
Each ping sends `keyLocation` = `<site>/indexnow-key.txt`.

## What is sent

`POST https://api.indexnow.org/indexnow` (the shared endpoint fans out to Bing
and Yandex) with `{ host, key, keyLocation, urlList }`. URLs are
`<site>/cluster/<id>` for clusters from `cluster-detail:<uuid>` tags received by
`POST /api/revalidate`, limited to non-archived clusters with `article_count >= 2`
(same eligibility as the clusters sitemap). The ping runs after the response.

## Limits

- At most 100 URLs per request.
- An id is not re-sent within 12 hours of a successful ping (200/202), per
  instance, up to 5,000 remembered ids.
- Process-local limiter: burst of 2, then 1 request per 30 seconds per instance.
- 5 second timeout.
- A 403, 422 or 429 response pauses pings on that instance for 60 minutes.
- Failures are logged as `[indexnow] ...` and never affect revalidation.

## Confirming it works

1. Open `https://<site>/indexnow-key.txt`: it must show the key.
2. Bing Webmaster Tools: Sitemaps and URL submission, IndexNow section, shows
   the submitted URLs and their status after a while.
3. Yandex Webmaster: Indexing, IndexNow, lists received notifications for the site.
4. Runtime logs: look for `[indexnow] sent N url(s) → 200` (or `202`).
