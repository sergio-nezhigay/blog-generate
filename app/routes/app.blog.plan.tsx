import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopifyArticles } from "../services/blog/shopifyBlog.server";
import {
  generateWeeklyPlan,
  getWeekStart,
  weekAlreadyPlanned,
} from "../services/blog/contentPlanner.server";
import { publishPlanItem } from "../services/blog/articleWriter.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [plans, settings] = await Promise.all([
    db.blogContentPlan.findMany({
      where: { shop: session.shop },
      orderBy: { scheduledDate: "desc" },
      take: 28,
    }),
    db.blogSettings.findUnique({ where: { shop: session.shop } }),
  ]);

  const weekStart = getWeekStart(new Date());
  const planExists = await weekAlreadyPlanned(session.shop, weekStart);

  return { plans, settings, planExists };
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

  if (intent === "publishNow") {
    const planId = parseInt(formData.get("planId") as string, 10);
    if (!planId) return { error: "Missing planId" };
    try {
      await publishPlanItem(admin, planId, session.shop);
      return { success: true, intent: "publishNow", planId };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Publish failed",
        intent: "publishNow",
      };
    }
  }

  if (intent === "resetToPlan") {
    const planId = parseInt(formData.get("planId") as string, 10);
    if (!planId) return { error: "Missing planId" };
    await db.blogContentPlan.update({
      where: { id: planId, shop: session.shop },
      data: { status: "planned", articleId: null, articleUrl: null, publishedAt: null, errorMessage: null },
    });
    return { success: true, intent: "resetToPlan" };
  }

  return { error: "Unknown intent" };
};

const STATUS_BADGE: Record<string, { tone: string; label: string }> = {
  planned: { tone: "neutral", label: "Planned" },
  published: { tone: "success", label: "Published" },
  failed: { tone: "critical", label: "Failed" },
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function BlogPlan() {
  const { plans, settings, planExists } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const isGenerating =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "generatePlan";

  const publishingPlanId =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "publishNow"
      ? Number(fetcher.formData.get("planId"))
      : null;

  const resettingPlanId =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "resetToPlan"
      ? Number(fetcher.formData.get("planId"))
      : null;

  function submitPublish(planId: number) {
    fetcher.submit({ intent: "publishNow", planId: String(planId) }, { method: "post" });
  }

  function submitReset(planId: number) {
    fetcher.submit({ intent: "resetToPlan", planId: String(planId) }, { method: "post" });
  }

  return (
    <s-page heading="Content Plan">
      {fetcher.data && "error" in fetcher.data && (
        <s-banner tone="critical">{fetcher.data.error}</s-banner>
      )}
      {fetcher.data && "success" in fetcher.data && fetcher.data.intent === "generatePlan" && (
        <s-banner tone="success">Weekly plan generated — 7 articles scheduled.</s-banner>
      )}
      {fetcher.data && "success" in fetcher.data && fetcher.data.intent === "publishNow" && (
        <s-banner tone="success">
          Article {settings?.testMode ? "created as draft (test mode)" : "published"} to Shopify.
        </s-banner>
      )}
      {fetcher.data && "success" in fetcher.data && fetcher.data.intent === "resetToPlan" && (
        <s-banner tone="info">Article reset to planned — ready to republish.</s-banner>
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
          <s-link href="/app/blog/settings">Settings</s-link>
        </s-stack>
      </s-section>

      {plans.length === 0 ? (
        <s-section>
          <s-paragraph>
            No articles planned yet. Click &quot;Generate Weekly Plan&quot; to create this
            week&apos;s content calendar.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading="Scheduled Articles">
          <div style={{ overflowX: "auto" }}><table style={tableStyle}>
            <thead>
              <tr>
                {["Date", "Day", "Category", "Topic", "Status", ""].map((h, i) => (
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
                const isPublishing = publishingPlanId === plan.id;
                return (
                  <tr key={plan.id} style={trStyle}>
                    <td style={tdStyle}>
                      {date.toLocaleDateString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        timeZone: "UTC",
                      })}
                    </td>
                    <td style={tdStyle}>{dayName}</td>
                    <td style={tdStyle}>
                      <span style={categoryStyle}>{plan.category}</span>
                    </td>
                    <td style={{ ...tdStyle, maxWidth: "340px" }}>
                      {plan.articleUrl ? (
                        <s-link href={plan.articleUrl} target="_blank">
                          {plan.topic}
                        </s-link>
                      ) : (
                        plan.topic
                      )}
                      {plan.errorMessage && (
                        <div style={{ color: "#d72c0d", fontSize: "12px", marginTop: "4px" }}>
                          {plan.errorMessage}
                        </div>
                      )}
                    </td>
                    <td style={tdStyle}>
                      <s-badge
                        tone={
                          badge.tone as
                            | "neutral"
                            | "success"
                            | "critical"
                            | "caution"
                            | "info"
                            | "warning"
                        }
                      >
                        {badge.label}
                      </s-badge>
                    </td>
                    <td style={{ ...tdStyle, width: "110px" }}>
                      {plan.status === "planned" || plan.status === "failed" ? (
                        <s-button
                          onClick={() => submitPublish(plan.id)}
                          {...(isPublishing ? { loading: true } : {})}
                          {...(publishingPlanId !== null && !isPublishing
                            ? { disabled: true }
                            : {})}
                        >
                          {isPublishing ? "Publishing…" : "Publish"}
                        </s-button>
                      ) : plan.status === "published" ? (
                        <button
                          onClick={() => submitReset(plan.id)}
                          disabled={resettingPlanId === plan.id || publishingPlanId !== null || (resettingPlanId !== null && resettingPlanId !== plan.id)}
                          style={resetBtnStyle}
                        >
                          {resettingPlanId === plan.id ? "…" : "Reset"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
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
  padding: "8px 12px",
  borderBottom: "2px solid #e1e3e5",
  fontWeight: 600,
  color: "#6d7175",
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #f1f2f3",
  verticalAlign: "top",
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

const resetBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#6d7175",
  fontSize: "13px",
  cursor: "pointer",
  padding: "4px 0",
  textDecoration: "underline",
};
