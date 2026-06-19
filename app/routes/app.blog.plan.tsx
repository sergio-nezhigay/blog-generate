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

    const existingArticles = await getShopifyArticles(admin, settings.blogId);
    const existingTitles = existingArticles.map((a) => a.title);

    await generateWeeklyPlan(session.shop, settings, existingTitles);
    return { success: true };
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

  return (
    <s-page heading="Content Plan">
      {fetcher.data && "error" in fetcher.data && (
        <s-banner tone="critical">{fetcher.data.error}</s-banner>
      )}
      {fetcher.data && "success" in fetcher.data && (
        <s-banner tone="success">Weekly plan generated — 7 articles scheduled.</s-banner>
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
          <s-link href="/app/blog/settings">
            Settings
          </s-link>
        </s-stack>
      </s-section>

      {plans.length === 0 ? (
        <s-section>
          <s-paragraph>
            No articles planned yet. Click "Generate Weekly Plan" to create
            this week's content calendar.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading="Scheduled Articles">
          <table style={tableStyle}>
            <thead>
              <tr>
                {["Date", "Day", "Category", "Topic", "Status"].map((h) => (
                  <th key={h} style={thStyle}>
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
                    <td style={{ ...tdStyle, maxWidth: "360px" }}>
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
                      <s-badge tone={badge.tone as "neutral" | "success" | "critical" | "caution" | "info" | "warning"}>
                        {badge.label}
                      </s-badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
