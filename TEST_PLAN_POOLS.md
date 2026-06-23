# Test Plan — Content Pool Manager

Covers every feature of `/app/blog/pools`. Steps marked **[YOU]** require the browser. Steps marked **[ME]** I run via terminal/DB query. Run in order — later steps depend on earlier ones.

---

## 0. Pre-flight: migration applied

**[ME]** Run on the live machine:
```
fly ssh console -a blog-generate -C "node -e \"const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.blogSettings.findFirst().then(r=>console.log(Object.keys(r))).finally(()=>p.\$disconnect())\""
```
**Expected:** output includes `extendedQAQuestions` and `extendedFashionCategories` in the key list.

**[ME]** Alternative — check migration table:
```
fly ssh console -a blog-generate -C "node -e \"const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.\$queryRaw\`SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5\`.then(r=>console.log(r)).finally(()=>p.\$disconnect())\""
```
**Expected:** `20260623000000_add_extended_pools` appears in the list.

---

## 1. Nav link visible

**[YOU]** Open the Shopify admin app (`admin.shopify.com/store/drmtdf-we/apps/blog-generate`).

**Expected:** Three nav items: `Home`, `Blog Automation`, `Content Pools`.

**Pass:** All three visible.  
**Fail:** "Content Pools" missing → check `app/routes/app.tsx` and redeploy.

---

## 2. Pools page loads

**[YOU]** Click **Content Pools** in the nav.

**Expected:**
- Page heading: "Content Pool Manager"
- Section 1: "QA Question Pools" — 7 cards visible (qa-eyeshadow, qa-powder, qa-brushes, qa-lashes, qa-brow-gel, qa-tweezers, qa-brush-wipes)
- Section 2: "Fashion Week Categories" — 7 hardcoded rows, grey background

**Specific numbers to verify (no articles published yet = used = 0):**

| Category | Total | Remaining | Status |
|----------|-------|-----------|--------|
| qa-eyeshadow | 29 | 29 | 🟢 Good |
| qa-powder | 19 | 19 | 🟢 Good |
| qa-brushes | 26 | 26 | 🟢 Good |
| qa-lashes | 5 | 5 | 🔴 Critical |
| qa-brow-gel | 9 | 9 | 🟡 Low |
| qa-tweezers | 10 | 10 | 🟡 Low |
| qa-brush-wipes | 9 | 9 | 🟡 Low |

> Note: qa-eyeshadow has 30 questions in code but 1 may be trimmed at load — if you see 29 or 30 both are correct.

**Pass:** Page loads, 7 cards visible, lashes shows 🔴, no "added by you" count on any card yet.  
**Fail:** Blank page → check fly logs (`fly logs -a blog-generate`) for loader errors.

---

## 3. Add a question manually (qa-lashes)

**[YOU]**
1. Find the `qa-lashes` card (5 questions · 🔴 Critical)
2. Click into the text input at the bottom of that card
3. Type: `How many times can false lashes be reused before they lose shape?`
4. Press **Enter** (or click **Add**)

**Expected immediately:**
- Input clears
- The question appears in a blue-tinted row above the input with a red ✕ button
- The counter updates: `6 questions total · 0 published · 6 remaining`
- Status changes from 🔴 Critical to 🟡 Low

**[ME]** Verify it was saved to DB:
```
fly ssh console -a blog-generate -C "node -e \"const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.blogSettings.findFirst().then(r=>console.log(JSON.stringify(r.extendedQAQuestions,null,2))).finally(()=>p.\$disconnect())\""
```
**Expected:** Output contains:
```json
{
  "qa-lashes": [
    "How many times can false lashes be reused before they lose shape?"
  ]
}
```

**Pass:** Question appears in UI, DB contains the entry.  
**Fail:** Question doesn't appear → network error; open browser DevTools → Network tab → look for POST to `/app/blog/pools` with 4xx/5xx status.

---

## 4. Add a second question manually (qa-lashes)

**[YOU]**
1. Same `qa-lashes` card
2. Type: `Do lashes with a transparent band look more natural than black band?`
3. Click **Add**

**Expected:** Now shows `7 questions total · 0 published · 7 remaining` — status still 🟡 Low.

---

## 5. Remove an extended question

**[YOU]**
1. In `qa-lashes`, find the first question you added: `How many times can false lashes be reused before they lose shape?`
2. Click the red **✕** next to it

**Expected:**
- Row disappears
- Counter drops back to `6 questions total · 0 published · 6 remaining`

**[ME]** Verify removal from DB:
```
fly ssh console -a blog-generate -C "node -e \"const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.blogSettings.findFirst().then(r=>console.log(JSON.stringify(r.extendedQAQuestions))).finally(()=>p.\$disconnect())\""
```
**Expected:** `qa-lashes` array has only 1 entry (the transparent band question), not 2.

**Pass:** Question removed from UI and DB.

---

## 6. Suggest 10 more (AI generation)

**[YOU]**
1. In the `qa-lashes` card, click **Suggest 10 more**
2. Button shows a loading state (~5 seconds for OpenAI call)

**Expected after loading:**
- Below the card, a blue-tinted suggestion list appears: "AI Suggestions — click ✓ to add, ✕ to skip:"
- 10 questions listed, each with ✓ and ✕ buttons
- None of the suggestions should be identical to the 5 hardcoded questions or the 1 you already added

**Pass:** 10 suggestions appear, none are obvious duplicates of existing pool.  
**Fail (button stays loading forever):** OpenAI API call timed out — check `fly logs -a blog-generate`.  
**Fail (0 suggestions):** `suggestQAQuestions` returned empty — likely all generated questions matched existing ones; try again.

---

## 7. Approve a suggestion

**[YOU]**
1. From the suggestion list, click **✓** on one question you like

**Expected:**
- That question disappears from the suggestion list (remaining 9 visible)
- It appears in the blue "added by you" rows above
- Counter increments: `7 questions total · 0 published · 7 remaining`

**Pass:** Question moves from suggestions to saved, counter updates.

---

## 8. Skip suggestions

**[YOU]**
1. Click **✕** on 3 suggestions in a row

**Expected:**
- Each disappears from the suggestion list immediately
- Counter does NOT change (skipped questions are not saved)
- Remaining suggestions stay visible

**Pass:** 3 gone, 6 remain in suggestion list, counter unchanged.

---

## 9. Approve remaining suggestions (bulk test)

**[YOU]**
1. Click **✓** on all remaining suggestions in the list

**Expected:**
- Suggestion list disappears (empty)
- All approved questions appear in the blue rows
- `qa-lashes` now shows ~13+ total questions (5 base + 1 manual + 6 from AI)
- Status upgrades to 🟢 Good

**Pass:** All questions saved, runway shows 🟢 Good.

---

## 10. Test manual add on a different category

**[YOU]**
1. Find `qa-brow-gel` card (9 questions · 🟡 Low)
2. Type in the input: `Can brow gel be used to set and laminate brow hairs?`
3. Press Enter

**Expected:** Question appears in qa-brow-gel's extended list. Counter: `10 questions total`.

**[ME]** Verify both categories are stored independently in DB:
```
fly ssh console -a blog-generate -C "node -e \"const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.blogSettings.findFirst().then(r=>{ const q=r.extendedQAQuestions; console.log('lashes:',q['qa-lashes']?.length,'brow-gel:',q['qa-brow-gel']?.length)}).finally(()=>p.\$disconnect())\""
```
**Expected:** `lashes: [N]  brow-gel: 1` — two separate keys in the JSON object.

---

## 11. Fashion: Suggest a new category

**[YOU]**
1. Scroll to "Fashion Week Categories" section
2. Click **Suggest a new category**
3. Button shows loading (~5 seconds)

**Expected:**
- A blue editing panel appears below the button
- Shows 4 editable fields: Slug, Format, Title Pattern, Target Word Count
- AI fills them with something sensible (not a duplicate of the 7 existing categories)
- "Add Category", "Discard", "Regenerate" buttons visible

**Pass:** Panel appears with valid-looking fields.  
**Fail:** Nothing appears → check fly logs for error in `suggestFashionCategory`.

---

## 12. Edit the proposed category before saving

**[YOU]**
1. In the editing panel, change the **Slug** field to something you prefer (e.g. `client-scenario`)
2. Change the **Target Word Count** to `2200`
3. Verify the **Title Pattern** field is editable

**Expected:** Fields update in real time as you type. No save happens yet.

---

## 13. Regenerate a fashion category proposal

**[YOU]**
1. Click **Regenerate**
2. Wait ~5 seconds

**Expected:**
- Panel updates with a different AI suggestion
- Your edits from step 12 are replaced by the new proposal

**Pass:** New different proposal appears (slug, format, or pattern differs from the last one).

---

## 14. Save a fashion category

**[YOU]**
1. After regenerating (or editing), click **Add Category**

**Expected:**
- Panel disappears
- A new "YOUR CATEGORIES" sub-section appears above the "Suggest" button with a blue-tinted row showing the new category
- "Suggest a new category" button reappears

**[ME]** Verify DB:
```
fly ssh console -a blog-generate -C "node -e \"const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.blogSettings.findFirst().then(r=>console.log(JSON.stringify(r.extendedFashionCategories,null,2))).finally(()=>p.\$disconnect())\""
```
**Expected:** Array with 1 object containing `name`, `format`, `titlePattern`, `targetWordCount`.

**Pass:** Category visible in UI and in DB.

---

## 15. Remove a fashion category

**[YOU]**
1. In "YOUR CATEGORIES", click the red **✕** next to the category you just added

**Expected:**
- Row disappears
- If no more extended categories, the "YOUR CATEGORIES" sub-section disappears too

**[ME]** Verify DB:
```
fly ssh console -a blog-generate -C "node -e \"const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.blogSettings.findFirst().then(r=>console.log('extended fashion count:',JSON.parse(JSON.stringify(r.extendedFashionCategories)).length)).finally(()=>p.\$disconnect())\""
```
**Expected:** `extended fashion count: 0`

---

## 16. Add 2 more fashion categories (rotation test setup)

**[YOU]**
1. Click **Suggest a new category** → Add (repeat twice to get 2 new extended categories)

After this step: 7 built-in + 2 extended = 9 total fashion categories. The planner will rotate through them.

**[ME]** Confirm count:
```
fly ssh console -a blog-generate -C "node -e \"const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.blogSettings.findFirst().then(r=>console.log('extended fashion:',JSON.parse(JSON.stringify(r.extendedFashionCategories)).length)).finally(()=>p.\$disconnect())\""
```
**Expected:** `extended fashion: 2`

---

## 17. Verify extended pools feed into the weekly planner

**[ME]** Trigger a dry-run preview of the weekly plan to confirm extended data is picked up:
```
fly ssh console -a blog-generate -C "curl -s -X POST 'http://localhost:3000/api/cron/weekly?preview=true&weekType=qa' -H 'x-cron-secret: '\"$CRON_SECRET\"'' | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{ try{const r=JSON.parse(d);r.forEach(s=>{ console.log(s.shop,s.weekType); s.topics?.forEach(t=>console.log(' ',t.category,'-',t.topic))})}catch(e){console.log(d)}})\""
```
**Expected:** Topics listed for each QA category. If you added questions to `qa-lashes`, the planner should now have more options available (won't fail due to exhaustion).

**Pass:** 7 topics generated, no `failed` or `exhausted` errors.  
**Fail:** If `qa-lashes` topic looks like a fallback (`C curl or D curl...` raw question reused verbatim) → extended pool not being read. Check `getFullQAPool` in `contentPlanner.server.ts`.

---

## 18. Page reload persistence check

**[YOU]**
1. Navigate away from Content Pools (go to Blog Automation)
2. Come back to Content Pools

**Expected:** All questions and categories you added are still there — counts unchanged. Data is in PostgreSQL, not browser memory.

**Pass:** Everything persists across navigation.

---

## Summary checklist

- [ ] Migration columns exist in DB (step 0)
- [ ] Nav link visible (step 1)
- [ ] Page loads with correct question counts (step 2)
- [ ] Manual add saves immediately and updates counter (step 3–4)
- [ ] Remove deletes from DB (step 5)
- [ ] AI suggest generates 10 non-duplicate questions (step 6)
- [ ] Approving a suggestion saves it (step 7)
- [ ] Skipping removes from list only, not DB (step 8)
- [ ] Multiple approvals work (step 9)
- [ ] Different categories stored independently (step 10)
- [ ] Fashion AI suggestion panel appears (step 11)
- [ ] Fields are editable before save (step 12)
- [ ] Regenerate replaces proposal (step 13)
- [ ] Save persists to DB (step 14)
- [ ] Remove deletes from DB (step 15)
- [ ] Extended fashion categories included in rotation (step 16–17)
- [ ] Data persists after navigation (step 18)
