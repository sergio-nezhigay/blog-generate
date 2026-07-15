import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  getShopifyArticles,
  checkArticlesExist,
  deleteShopifyArticle,
  updateArticlePublished,
} from "../services/blog/shopifyBlog.server";
import {
  generateWeeklyPlan,
  getWeekStart,
  weekAlreadyPlanned,
  type PlanResult,
} from "../services/blog/contentPlanner.server";
import { publishPlanItem } from "../services/blog/articleWriter.server";

const PAGE_SIZE = 15;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);

  const [plans, totalCount, settings] = await Promise.all([
    db.blogContentPlan.findMany({
      where: { shop: session.shop },
      orderBy: { scheduledDate: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.blogContentPlan.count({ where: { shop: session.shop } }),
    db.blogSettings.findUnique({ where: { shop: session.shop } }),
  ]);
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // On-demand Shopify sync: detect articles deleted outside the app
  const publishedPlans = plans.filter(
    (p) => (p.status === "published" || p.status === "draft") && p.articleId,
  );
  if (publishedPlans.length > 0) {
    const ids = publishedPlans.map((p) => p.articleId!);
    try {
      const existingIds = await checkArticlesExist(admin, ids);
      const missingIds = ids.filter((id) => !existingIds.has(id));
      if (missingIds.length > 0) {
        await db.blogContentPlan.updateMany({
          where: { articleId: { in: missingIds }, shop: session.shop },
          data: { status: "deleted" },
        });
        // Reflect updates in returned data without a second DB round-trip
        for (const plan of plans) {
          if (plan.articleId && missingIds.includes(plan.articleId)) {
            plan.status = "deleted";
          }
        }
      }
    } catch (syncErr) {
      // Non-fatal: sync failure should not break the page
      console.error("[plan loader] Shopify sync error:", syncErr instanceof Error ? syncErr.message : syncErr);
    }
  }

  const weekStart = getWeekStart(new Date());
  const planExists = await weekAlreadyPlanned(session.shop, weekStart);

  // Translation progress per plan (only meaningful for published articles)
  const publishedPlanIds = plans.filter((p) => p.status === "published").map((p) => p.id);
  const translationCounts: Record<number, { done: number; total: number }> = {};
  if (publishedPlanIds.length > 0) {
    const rows = await db.articleTranslation.findMany({
      where: { planId: { in: publishedPlanIds } },
      select: { planId: true, status: true },
    });
    for (const row of rows) {
      const entry = translationCounts[row.planId] ?? { done: 0, total: 0 };
      entry.total += 1;
      if (row.status === "done") entry.done += 1;
      translationCounts[row.planId] = entry;
    }
  }

  return { plans, settings, planExists, translationCounts, page, totalPages, totalCount };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "generatePlan") {
    const settings = await db.blogSettings.findUnique({
      where: { shop: session.shop },
    });
    if (!settings?.blogId) {
      return { error: "Configure a blog in Settings before generating a plan." };
    }
    const { articles: existingArticles } = await getShopifyArticles(admin, settings.blogId);
    const existingTitles = existingArticles.map((a) => a.title);
    await generateWeeklyPlan(session.shop, settings, existingTitles);
    return { success: true, intent: "generatePlan" };
  }

  if (intent === "dryRun") {
    const settings = await db.blogSettings.findUnique({
      where: { shop: session.shop },
    });
    if (!settings?.blogId) {
      return { error: "Configure a blog in Settings before running a simulation." };
    }
    const { articles: existingArticles } = await getShopifyArticles(admin, settings.blogId);
    const existingTitles = existingArticles.map((a) => a.title);
    const result: PlanResult = await generateWeeklyPlan(session.shop, settings, existingTitles, { dryRun: true });
    return { success: true, intent: "dryRun", dryRunResult: result };
  }

  if (intent === "publishNow") {
    const planId = parseInt(formData.get("planId") as string, 10);
    if (!planId) return { error: "Missing planId" };
    try {
      await publishPlanItem(admin, planId, session.shop);
      const settings = await db.blogSettings.findUnique({ where: { shop: session.shop } });
      return { success: true, intent: "publishNow", planId, isDraft: !!settings?.testMode };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Publish failed",
        intent: "publishNow",
      };
    }
  }

  if (intent === "publishLive") {
    // Promote a Shopify draft article to live (test mode was on when it was created)
    const planId = parseInt(formData.get("planId") as string, 10);
    if (!planId) return { error: "Missing planId" };
    const plan = await db.blogContentPlan.findUnique({
      where: { id: planId, shop: session.shop },
    });
    if (!plan?.articleId) return { error: "No article linked to this plan item" };
    try {
      const promoted = await updateArticlePublished(admin, plan.articleId);
      const storefrontUrl = `https://${session.shop}/blogs/${promoted.blogHandle}/${promoted.handle}`;
      await db.blogContentPlan.update({
        where: { id: planId },
        data: { status: "published", articleUrl: storefrontUrl },
      });
      return { success: true, intent: "publishLive" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to publish live", intent: "publishLive" };
    }
  }

  if (intent === "resetToPlan") {
    // Deletes the article from Shopify (if it exists) and resets the plan row to "planned"
    const planId = parseInt(formData.get("planId") as string, 10);
    if (!planId) return { error: "Missing planId" };
    const plan = await db.blogContentPlan.findUnique({
      where: { id: planId, shop: session.shop },
    });
    if (!plan) return { error: "Plan not found" };

    if ((plan.status === "published" || plan.status === "draft") && plan.articleId) {
      try {
        await deleteShopifyArticle(admin, plan.articleId);
      } catch (err) {
        console.error("[resetToPlan] Shopify delete error:", err instanceof Error ? err.message : err);
        // Continue even if Shopify delete fails — the article may already be gone
      }
    }

    await db.blogContentPlan.update({
      where: { id: planId, shop: session.shop },
      data: {
        status: "planned",
        generatingStartedAt: null,
        articleId: null,
        articleUrl: null,
        publishedAt: null,
        errorMessage: null,
      },
    });
    return { success: true, intent: "resetToPlan" };
  }

  if (intent === "dismissToPlan") {
    // Clears failed/deleted status back to planned without any Shopify API call
    const planId = parseInt(formData.get("planId") as string, 10);
    if (!planId) return { error: "Missing planId" };
    await db.blogContentPlan.update({
      where: { id: planId, shop: session.shop },
      data: {
        status: "planned",
        generatingStartedAt: null,
        articleId: null,
        articleUrl: null,
        publishedAt: null,
        errorMessage: null,
      },
    });
    return { success: true, intent: "dismissToPlan" };
  }

  return { error: "Unknown intent" };
};

const STATUS_BADGE: Record<string, { tone: "neutral" | "success" | "critical" | "caution" | "info" | "warning"; label: string; subText?: string }> = {
  planned:    { tone: "neutral",   label: "Planned" },
  generating: { tone: "info",      label: "Generating…" },
  draft:      { tone: "warning",   label: "Draft",     subText: "Not live on storefront" },
  published:  { tone: "success",   label: "Published" },
  failed:     { tone: "critical",  label: "Failed" },
  deleted:    { tone: "critical",  label: "Deleted",   subText: "Removed from Shopify" },
};

const STATUS_COLOR: Record<string, string> = {
  planned:    "#8c9196",
  generating: "#2c6ecb",
  draft:      "#b98900",
  published:  "#008060",
  failed:     "#d72c0d",
  deleted:    "#d72c0d",
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function BlogPlan() {
  const { plans, settings, planExists, translationCounts, page, totalPages, totalCount } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [, setSearchParams] = useSearchParams();

  function goToPage(nextPage: number) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("page", String(nextPage));
      return next;
    });
  }

  const isGenerating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generatePlan";

  const isSimulating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "dryRun";

  const dryRunResult =
    fetcher.data && "dryRunResult" in fetcher.data
      ? (fetcher.data as { dryRunResult: PlanResult }).dryRunResult
      : null;

  const publishingPlanId =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "publishNow"
      ? Number(fetcher.formData.get("planId"))
      : null;

  const publishingLivePlanId =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "publishLive"
      ? Number(fetcher.formData.get("planId"))
      : null;

  const resettingPlanId =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "resetToPlan"
      ? Number(fetcher.formData.get("planId"))
      : null;

  const dismissingPlanId =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "dismissToPlan"
      ? Number(fetcher.formData.get("planId"))
      : null;

  const anyActionInProgress = fetcher.state !== "idle";

  function submitPublish(planId: number) {
    fetcher.submit({ intent: "publishNow", planId: String(planId) }, { method: "post" });
  }

  function submitPublishLive(planId: number) {
    fetcher.submit({ intent: "publishLive", planId: String(planId) }, { method: "post" });
  }

  function submitReset(planId: number) {
    fetcher.submit({ intent: "resetToPlan", planId: String(planId) }, { method: "post" });
  }

  function submitDismiss(planId: number) {
    fetcher.submit({ intent: "dismissToPlan", planId: String(planId) }, { method: "post" });
  }

  // Summary counts
  const counts = plans.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {});

  const actionData = fetcher.data;

  return (
    <s-page heading="Content Plan">
      {actionData && "error" in actionData && (
        <s-banner tone="critical">{actionData.error}</s-banner>
      )}
      {actionData && "success" in actionData && actionData.intent === "generatePlan" && (
        <s-banner tone="success">Weekly plan generated — 7 articles scheduled.</s-banner>
      )}
      {actionData && "success" in actionData && actionData.intent === "publishNow" && (
        <s-banner tone="success">
          Article {(actionData as { isDraft?: boolean }).isDraft ? "created as draft (test mode)" : "published"} to Shopify.
        </s-banner>
      )}
      {actionData && "success" in actionData && actionData.intent === "publishLive" && (
        <s-banner tone="success">Draft article published live to Shopify.</s-banner>
      )}
      {actionData && "success" in actionData && actionData.intent === "resetToPlan" && (
        <s-banner tone="info">Article deleted from Shopify and reset to planned.</s-banner>
      )}
      {actionData && "success" in actionData && actionData.intent === "dismissToPlan" && (
        <s-banner tone="info">Article cleared — ready to regenerate.</s-banner>
      )}
      {settings?.testMode && (
        <s-banner tone="warning">
          Test mode is ON — articles publish as drafts (not visible on storefront, not indexed by Google).
          Disable in <s-link href="/app/blog/settings">Settings</s-link>.
        </s-banner>
      )}
      {!settings?.blogId && (
        <s-banner tone="warning">
          No blog selected. Go to{" "}
          <s-link href="/app/blog/settings">Settings</s-link> first.
        </s-banner>
      )}

      <s-section heading="This Week">
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={() =>
              fetcher.submit({ intent: "generatePlan" }, { method: "post" })
            }
            {...(isGenerating ? { loading: true } : {})}
            {...(planExists ? { disabled: true } : {})}
          >
            {planExists ? "Plan already generated" : "Generate Weekly Plan"}
          </s-button>
          <s-button
            variant="secondary"
            onClick={() => fetcher.submit({ intent: "dryRun" }, { method: "post" })}
            {...(isSimulating ? { loading: true } : {})}
          >
            Simulate next week
          </s-button>
          <s-link href="/app/blog/settings">Settings</s-link>
        </s-stack>
      </s-section>

      {dryRunResult && (
        <s-section heading={`Simulation — ${dryRunResult.weekType === "fashion" ? "Fashion" : "Q&A"} week`}>
          <div style={{ border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  {["Day", "Topic (not saved)"].map((h, i) => (
                    <th key={i} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dryRunResult.topics.map((t) => (
                  <tr key={t.dayIndex} style={trStyle}>
                    <td style={{ ...dateCellStyle, borderLeft: "4px solid #8c9196" }}>
                      <div style={{ fontWeight: 600, fontSize: "13px" }}>{DAY_NAMES[t.dayIndex] ?? t.dayIndex}</div>
                      <div style={{ marginTop: "4px" }}><span style={categoryStyle}>{t.category}</span></div>
                    </td>
                    <td style={tdStyle}>{t.topic}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
          <p style={noteStyle}>Simulation only — no articles saved or scheduled.</p>
        </s-section>
      )}

      {plans.length === 0 ? (
        <s-section>
          <s-paragraph>
            No articles planned yet. Click &quot;Generate Weekly Plan&quot; to create this
            week&apos;s content calendar.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading="Scheduled Articles">
          {/* Summary row */}
          {plans.length > 0 && (
            <div style={summaryStyle}>
              {counts.published ? <span style={summaryItemStyle}><span style={{ color: "#008060" }}>●</span> {counts.published} Published</span> : null}
              {counts.draft ? <span style={summaryItemStyle}><span style={{ color: "#b98900" }}>●</span> {counts.draft} Draft</span> : null}
              {counts.generating ? <span style={summaryItemStyle}><span style={{ color: "#2c6ecb" }}>●</span> {counts.generating} Generating</span> : null}
              {counts.planned ? <span style={summaryItemStyle}><span style={{ color: "#8c9196" }}>●</span> {counts.planned} Planned</span> : null}
              {counts.failed ? <span style={summaryItemStyle}><span style={{ color: "#d72c0d" }}>●</span> {counts.failed} Failed</span> : null}
              {counts.deleted ? <span style={summaryItemStyle}><span style={{ color: "#d72c0d" }}>●</span> {counts.deleted} Deleted</span> : null}
            </div>
          )}
          <div style={{ border: "1px solid #e1e3e5", borderRadius: "8px", overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}><table style={tableStyle}>
            <thead>
              <tr>
                {["Date", "Topic", "Status", "Actions"].map((h, i) => (
                  <th key={i} style={thStyle}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plans.map((plan: typeof plans[number]) => {
                const badge = STATUS_BADGE[plan.status] ?? STATUS_BADGE.planned;
                const date = new Date(plan.scheduledDate);
                const dayName = DAY_NAMES[plan.dayIndex] ?? "";
                const isThisPublishing = publishingPlanId === plan.id;
                const isThisPublishingLive = publishingLivePlanId === plan.id;
                const isThisResetting = resettingPlanId === plan.id;
                const isThisDismissing = dismissingPlanId === plan.id;

                // Optimistic generating state: show spinner row when publish is in progress
                const effectiveStatus = isThisPublishing ? "generating" : plan.status;
                const effectiveBadge = STATUS_BADGE[effectiveStatus] ?? badge;

                const rowStyle: React.CSSProperties = {
                  ...trStyle,
                  ...(effectiveStatus === "generating" ? { background: "#f0f6ff" } : {}),
                  ...(effectiveStatus === "failed" || effectiveStatus === "deleted" ? { background: "#fff5f5" } : {}),
                };

                return (
                  <tr key={plan.id} style={rowStyle}>
                    <td style={{ ...dateCellStyle, borderLeft: `4px solid ${STATUS_COLOR[effectiveStatus] ?? "#8c9196"}` }}>
                      <div style={{ fontWeight: 600, fontSize: "13px" }}>
                        {date.toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                          timeZone: "UTC",
                        })}
                      </div>
                      <div style={{ fontSize: "11px", color: "#8c9196", marginTop: "2px" }}>{dayName}</div>
                    </td>
                    <td style={{ ...tdStyle, maxWidth: "340px" }}>
                      {plan.articleUrl ? (
                        <s-link href={plan.articleUrl} target="_blank">
                          {plan.topic}
                        </s-link>
                      ) : (
                        <span style={{ color: "#202223", fontWeight: 500 }}>{plan.topic}</span>
                      )}
                      <div style={{ marginTop: "5px" }}>
                        <span style={categoryStyle}>{plan.category}</span>
                      </div>
                      {plan.errorMessage && plan.status === "failed" && (
                        <details style={{ marginTop: "4px" }}>
                          <summary style={{ color: "#d72c0d", fontSize: "12px", cursor: "pointer" }}>
                            Show error
                          </summary>
                          <div style={{ color: "#d72c0d", fontSize: "12px", marginTop: "2px", wordBreak: "break-word" }}>
                            {plan.errorMessage}
                          </div>
                        </details>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <s-badge tone={effectiveBadge.tone}>
                        {effectiveBadge.label}
                      </s-badge>
                      {effectiveBadge.subText && (
                        <div style={{ fontSize: "11px", color: "#6d7175", marginTop: "2px" }}>
                          {effectiveBadge.subText}
                        </div>
                      )}
                      {plan.status === "published" && plan.publishedAt && (
                        <div style={{ fontSize: "11px", color: "#6d7175", marginTop: "2px" }}>
                          {new Date(plan.publishedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })}
                        </div>
                      )}
                      {plan.status === "published" && settings?.translationEnabled && translationCounts[plan.id] && (
                        <div style={{ fontSize: "11px", color: "#6d7175", marginTop: "2px" }}>
                          {translationCounts[plan.id].done}/{translationCounts[plan.id].total} translated
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdStyle, width: "160px" }}>
                      {plan.status === "planned" && (
                        <s-button
                          onClick={() => submitPublish(plan.id)}
                          {...(isThisPublishing ? { loading: true } : {})}
                          {...(anyActionInProgress && !isThisPublishing ? { disabled: true } : {})}
                        >
                          Generate
                        </s-button>
                      )}

                      {plan.status === "generating" && !isThisPublishing && (
                        <span style={{ fontSize: "13px", color: "#2c6ecb" }}>In progress…</span>
                      )}

                      {plan.status === "draft" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <s-button
                            onClick={() => submitPublishLive(plan.id)}
                            {...(isThisPublishingLive ? { loading: true } : {})}
                            {...(anyActionInProgress && !isThisPublishingLive ? { disabled: true } : {})}
                          >
                            {isThisPublishingLive ? "Going live…" : "Go Live"}
                          </s-button>
                          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "2px" }}>
                            {plan.articleUrl && (
                              <s-link href={plan.articleUrl} target="_blank">Edit in Admin ↗</s-link>
                            )}
                            <button
                              onClick={() => submitReset(plan.id)}
                              disabled={anyActionInProgress}
                              style={linkBtnStyle}
                            >
                              {isThisResetting ? "…" : "Delete"}
                            </button>
                          </div>
                        </div>
                      )}

                      {plan.status === "published" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          {plan.articleUrl && (
                            <s-link href={plan.articleUrl} target="_blank">View Article ↗</s-link>
                          )}
                          <button
                            onClick={() => submitReset(plan.id)}
                            disabled={anyActionInProgress}
                            style={linkBtnStyle}
                          >
                            {isThisResetting ? "…" : "Unpublish"}
                          </button>
                        </div>
                      )}

                      {plan.status === "failed" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <s-button
                            onClick={() => submitPublish(plan.id)}
                            {...(isThisPublishing ? { loading: true } : {})}
                            {...(anyActionInProgress && !isThisPublishing ? { disabled: true } : {})}
                          >
                            {isThisPublishing ? "Generating…" : "Retry"}
                          </s-button>
                          <button
                            onClick={() => submitDismiss(plan.id)}
                            disabled={anyActionInProgress}
                            style={linkBtnStyle}
                          >
                            {isThisDismissing ? "…" : "Dismiss"}
                          </button>
                        </div>
                      )}

                      {plan.status === "deleted" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <s-button
                            onClick={() => submitPublish(plan.id)}
                            {...(isThisPublishing ? { loading: true } : {})}
                            {...(anyActionInProgress && !isThisPublishing ? { disabled: true } : {})}
                          >
                            {isThisPublishing ? "Publishing…" : "Republish"}
                          </s-button>
                          <button
                            onClick={() => submitDismiss(plan.id)}
                            disabled={anyActionInProgress}
                            style={linkBtnStyle}
                          >
                            {isThisDismissing ? "…" : "Dismiss"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          </div>
          {totalPages > 1 && (
            <div style={paginationStyle}>
              <s-button
                variant="secondary"
                onClick={() => goToPage(page - 1)}
                {...(page <= 1 ? { disabled: true } : {})}
              >
                Previous
              </s-button>
              <span style={{ fontSize: "13px", color: "#6d7175" }}>
                Page {page} of {totalPages} ({totalCount} total)
              </span>
              <s-button
                variant="secondary"
                onClick={() => goToPage(page + 1)}
                {...(page >= totalPages ? { disabled: true } : {})}
              >
                Next
              </s-button>
            </div>
          )}
          <p style={noteStyle}>
            Publishing takes 90–120 seconds (keywords → research → article → images → Shopify). Keep this page open.
          </p>
        </s-section>
      )}
    </s-page>
  );
}

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "14px",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 16px",
  borderBottom: "1px solid #e1e3e5",
  fontWeight: 600,
  color: "#6d7175",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tdStyle: React.CSSProperties = {
  padding: "14px 16px",
  borderBottom: "1px solid #f1f2f3",
  verticalAlign: "top",
};

const dateCellStyle: React.CSSProperties = {
  ...tdStyle,
  whiteSpace: "nowrap",
  width: "80px",
};

const trStyle: React.CSSProperties = {};

const categoryStyle: React.CSSProperties = {
  fontSize: "12px",
  padding: "2px 8px",
  borderRadius: "12px",
  background: "#f1f2f3",
  color: "#6d7175",
  whiteSpace: "nowrap",
};

const noteStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#6d7175",
  marginTop: "8px",
  padding: "0 12px",
};

const summaryStyle: React.CSSProperties = {
  display: "flex",
  gap: "16px",
  padding: "8px 12px",
  marginBottom: "8px",
  fontSize: "13px",
  color: "#6d7175",
  flexWrap: "wrap",
};

const paginationStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "16px",
  padding: "16px 12px 4px",
};

const summaryItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "5px",
};

const linkBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#6d7175",
  fontSize: "12px",
  cursor: "pointer",
  padding: "0",
  textDecoration: "underline",
  textAlign: "left",
};
