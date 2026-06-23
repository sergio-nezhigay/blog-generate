

**3. LSI Keywords in keyword enrichment**  
Prototype generates primary keywords + LSI (semantically related) keywords separately. LSI keywords woven through article body signal topical depth to Google. Currently we generate a flat keyword list with no distinction.  
*Files:* `articleWriter.server.ts`


**5. Format-aware article structure**  
The `contentFormat` field exists in the DB (listicle, comparison, guide, technical) but the generation prompt is identical for all formats. Prototype varies structure significantly: listicle gets numbered H2s + summary table, comparison gets feature table + winner declarations, guide gets `<ol>` steps + Pro Tip boxes, technical gets `<pre><code>` blocks.  
*Files:* `articleWriter.server.ts`

**6. Article Refresher**  
Weekly pass that detects articles with stale year references in titles (e.g. "Best Tools in 2025"), asks GPT to update the title and relevant date/stat phrases to the current year. Keeps older content evergreen. Prototype runs weekly on Mondays.  
*Files:* new `articleRefresher.server.ts`, new `api.cron.refresh.tsx`, `cron-runner.mjs`

**7. Image Generation**  -
correct ratio for target images


**8. Internal Linker**  
Post-publish pass that reads all published articles, finds ones with fewer than 3 internal links, and uses GPT to identify natural anchor text opportunities pointing to topically related articles. Also adds a `/pages/services` link if missing, and reverse-links newer articles from older ones that mention them. Runs weekly. Significant SEO value (internal link equity distribution).  
*Files:* new `internalLinker.server.ts`, new `api.cron.linker.tsx`, `cron-runner.mjs`

9 - Add a block with 3 last articles on this topic



